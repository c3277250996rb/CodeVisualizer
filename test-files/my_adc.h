#ifndef MY_ADC_H
#define MY_ADC_H

#define MY_ADC_EVENT_NONE 0U
#define MY_ADC_EVENT_SC_READY 1U

void MyAdc_Init(void);
unsigned char MyAdc_Task(void);
extern unsigned int sc_raw;
#define MY_ADC_SC_RAW() (sc_raw)

#endif